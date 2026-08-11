import {
  decodeArchivedDvdTitles,
  DISC_SELECTION_KINDS,
  DomainInvariantError,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  MEDIA_ITEM_KINDS,
  RecordNotFoundError,
  type DataAccess,
  type CreateDiscSelectionInput,
  type DiscSelection,
  type DiscSelectionId,
  type MediaItem,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";

import { parseCatalogReviewCommand } from "../../../../lib/catalog-review-command";
import { getDataAccess } from "../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATALOG_REVIEW_MEDIA_PAGE_SIZE = 100;
const CATALOG_REVIEW_SELECTION_PAGE_SIZE = 100;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function headerOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function mutationRequestProblem(
  request: Request,
  trustedOrigin: string,
): Response | null {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return response({ error: "JSON content type required" }, 415);
  }
  const origin = request.headers.get("Origin");
  const host = request.headers.get("Host")?.trim().toLowerCase();
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  const trustedUrl = new URL(trustedOrigin);
  if (
    origin === null ||
    headerOrigin(origin) !== trustedUrl.origin ||
    host === undefined ||
    host !== trustedUrl.host.toLowerCase() ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return response({ error: "Cross-origin mutation rejected" }, 403);
  }
  return null;
}

function boundedString(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function recordOffset(request: Request, parameter: string): number | null {
  const value = new URL(request.url).searchParams.get(parameter);
  if (value === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

function optionalRecordId(
  request: Request,
  parameter: string,
): string | null | undefined {
  const value = new URL(request.url).searchParams.get(parameter);
  return value === null ? undefined : boundedString(value);
}

function serializeMediaItem(item: MediaItem) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
  };
}

function serializeDiscSelection(selection: DiscSelection) {
  return {
    id: selection.id,
    mediaItemId: selection.mediaItemId,
    sourceKey: selection.sourceKey,
    kind: selection.kind,
    titleNumber: selection.titleNumber,
    chapterStart: selection.chapterStart,
    chapterEnd: selection.chapterEnd,
    label: selection.label,
  };
}

function readCatalogReview(
  access: DataAccess,
  id: OriginalDiscArchiveId,
  mediaItemOffset: number,
  discSelectionOffset: number,
  editingMediaItemId?: MediaItemId,
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
    const mediaItems = snapshot.catalog.listMediaItems({
      limit: CATALOG_REVIEW_MEDIA_PAGE_SIZE + 1,
      offset: mediaItemOffset,
    });
    const discSelections = snapshot.catalog.listDiscSelections({
      originalDiscArchiveId: id,
      limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE + 1,
      offset: discSelectionOffset,
    });
    const hasNextMediaItems =
      mediaItems.length > CATALOG_REVIEW_MEDIA_PAGE_SIZE;
    const mediaItemsPage = mediaItems.slice(
      0,
      CATALOG_REVIEW_MEDIA_PAGE_SIZE,
    );
    const hasNextDiscSelections =
      discSelections.length > CATALOG_REVIEW_SELECTION_PAGE_SIZE;
    const discSelectionsPage = discSelections.slice(
      0,
      CATALOG_REVIEW_SELECTION_PAGE_SIZE,
    );
    const mediaItemPageIds = new Set(mediaItemsPage.map((item) => item.id));
    const mediaItemsById = new Map(
      mediaItemsPage.map((item) => [item.id, item]),
    );
    const seedIds = [
      ...mediaItemsPage.map((item) => item.id),
      ...discSelectionsPage.map((selection) => selection.mediaItemId),
      editingMediaItemId,
    ].filter(
      (itemId): itemId is MediaItemId =>
        itemId !== null && itemId !== undefined,
    );
    const processedDepths = new Map<MediaItemId, number>();
    let pendingDepths = new Map(seedIds.map((itemId) => [itemId, 1]));
    while (pendingDepths.size > 0) {
      const currentDepths = pendingDepths;
      pendingDepths = new Map();
      const missingIds = [...currentDepths.keys()].filter(
        (itemId) => !mediaItemsById.has(itemId),
      );
      const contextItems = missingIds.length === 0
        ? []
        : snapshot.catalog.listMediaItems({ ids: missingIds });
      for (const item of contextItems) {
        mediaItemsById.set(item.id, item);
      }
      for (const [itemId, depth] of currentDepths) {
        if ((processedDepths.get(itemId) ?? 0) >= depth) {
          continue;
        }
        processedDepths.set(itemId, depth);
        const item = mediaItemsById.get(itemId);
        if (item?.parentId !== null && item?.parentId !== undefined) {
          const parentDepth = depth + 1;
          if (parentDepth > MAX_MEDIA_ITEM_HIERARCHY_DEPTH) {
            throw new DomainInvariantError(
              "Media Item hierarchy exceeds the supported depth",
            );
          }
          if (
            (processedDepths.get(item.parentId) ?? 0) < parentDepth &&
            (pendingDepths.get(item.parentId) ?? 0) < parentDepth
          ) {
            pendingDepths.set(item.parentId, parentDepth);
          }
        }
      }
    }
    const contextMediaItems = [...mediaItemsById.values()].filter(
      (item) => !mediaItemPageIds.has(item.id),
    );
    return {
      archive: {
        id: archive.id,
        discLabel: disc.volumeLabel ?? "Unlabeled disc",
        discKind: archive.discKind,
        archiveFormat: archive.archiveFormat,
        archivedAt: archive.archivedAt.toISOString(),
        catalogReviewedAt: archive.catalogReviewedAt?.toISOString() ?? null,
      },
      reviewStatus:
        archive.catalogReviewedAt === null ? "needs_review" : "reviewed",
      rawScan: {
        titles: decodeArchivedDvdTitles(disc.scanData) ?? [],
      },
      mediaItems: [...contextMediaItems, ...mediaItemsPage].map(
        serializeMediaItem,
      ),
      mediaItemsPage: {
        offset: mediaItemOffset,
        limit: CATALOG_REVIEW_MEDIA_PAGE_SIZE,
        hasPrevious: mediaItemOffset > 0,
        hasNext: hasNextMediaItems,
        itemIds: mediaItemsPage.map((item) => item.id),
      },
      discSelections: discSelectionsPage.map(serializeDiscSelection),
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
      const mediaItemOffset = recordOffset(request, "mediaOffset");
      const discSelectionOffset = recordOffset(request, "selectionOffset");
      const editingMediaItemId = optionalRecordId(
        request,
        "editingMediaItemId",
      );
      if (
        mediaItemOffset === null ||
        discSelectionOffset === null ||
        editingMediaItemId === null
      ) {
        return response({ error: "Invalid Media Item offset" }, 400);
      }
      const review = readCatalogReview(
        getAccess(),
        archiveId,
        mediaItemOffset,
        discSelectionOffset,
        editingMediaItemId as MediaItemId | undefined,
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
    const problem = mutationRequestProblem(request, trustedOrigin);
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
        discSelectionKinds: DISC_SELECTION_KINDS,
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
      case "create_media_item": {
        const input = command.mediaItem;
        const item = access.catalog.createMediaItem({
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
        });
        return response({ mediaItem: serializeMediaItem(item) }, 201);
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
        return response({ mediaItem: serializeMediaItem(item) });
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
        let selection: DiscSelection;
        switch (input.kind) {
          case "main_feature":
            selection = saveSelection({ ...common, kind: input.kind });
            break;
          case "dvd_title":
            selection = saveSelection({
              ...common,
              kind: input.kind,
              titleNumber: input.titleNumber,
            });
            break;
          case "dvd_chapters":
            selection = saveSelection({
              ...common,
              kind: input.kind,
              titleNumber: input.titleNumber,
              chapterStart: input.chapterStart,
              chapterEnd: input.chapterEnd,
            });
            break;
          default:
            input satisfies never;
            throw new Error("Unhandled Disc Selection kind");
        }
        return response(
          { discSelection: serializeDiscSelection(selection) },
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
          discSelection: serializeDiscSelection(selection),
          deletedEncodeJobs: deletion.deletedEncodeJobs,
          deletionComplete: deletion.deletionComplete,
        });
      }

      case "complete_review": {
        const archive = access.catalog.completeCatalogReview(archiveId);
        return response({
          archive: {
            id: archive.id,
            catalogReviewedAt:
              archive.catalogReviewedAt?.toISOString() ?? null,
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
